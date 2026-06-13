/**
 * /app/refill/skills — "Your Skills" (v2.19.0, Phase 1).
 *
 * The cross-solution surface for the Ownership Flywheel's active half
 * (project_skill_funnel). She browses the curated catalog, adopts a Skill with
 * one tap (the gate), and it becomes a routine she OWNS — manageable, and
 * removable (honest exit). Earned-gated: hidden behind a gentle locked state
 * until her first verified win, so premature Skills stay noise-free. An admin
 * viewing-as a tenant bypasses the gate (operator context is never blocked).
 *
 * Honesty bar: only `live` templates can be adopted; `preview` ones are shown
 * (so she sees the breadth) but clearly marked "coming soon." Phase 1 wires
 * exactly one template end-to-end (Pre-Visit Reminders → the Reminders engine).
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  Check,
  Loader2,
  Lock,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  SKILL_CATALOG,
  findSkillInCatalog,
  skillSolutionLabel,
  type SkillTemplate,
} from "@/lib/skill-catalog";
import { hasReachedValueMoment } from "@/server/wishlist.functions";
import {
  adoptSkill,
  dismissSuggestion,
  listMySkills,
  listSuggestedSkills,
  removeSkill,
  setSkillEnabled,
  type AdoptedSkill,
  type SuggestedSkill,
} from "@/server/skills.functions";

export const Route = createFileRoute("/app/refill/skills")({
  component: SkillsPage,
});

async function token(): Promise<string> {
  const { data: sess } = await supabase.auth.getSession();
  const t = sess.session?.access_token;
  if (!t) throw new Error("Please sign in again.");
  return t;
}

function SkillsPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;
  // An admin explicitly viewing-as a tenant is operator context — never gate them.
  const adminViewing =
    membership.status === "tenant" && membership.viewAsExplicit === true;

  const [valueMoment, setValueMoment] = useState<boolean | null>(null);
  const [skills, setSkills] = useState<AdoptedSkill[] | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestedSkill[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const t = await token();
      const [{ reached }, mine, suggested] = await Promise.all([
        hasReachedValueMoment({ data: { accessToken: t, viewAsUserId } }),
        listMySkills({ data: { accessToken: t, viewAsUserId } }),
        listSuggestedSkills({ data: { accessToken: t, viewAsUserId } }),
      ]);
      setValueMoment(reached);
      setSkills(mine);
      setSuggestions(suggested);
    } catch (e) {
      // Fail closed on the gate (don't show prematurely); empty list otherwise.
      setValueMoment((v) => (v === null ? false : v));
      setSkills((s) => s ?? []);
      toast.error(e instanceof Error ? e.message : "Couldn't load your Skills.");
    }
  }, [viewAsUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  const adoptedByKey = useMemo(() => {
    const m = new Map<string, AdoptedSkill>();
    for (const s of skills ?? []) m.set(s.templateKey, s);
    return m;
  }, [skills]);

  const unlocked = adminViewing || valueMoment === true;

  const adopt = async (
    tpl: { key: string; label: string },
    source: "catalog" | "mined" = "catalog",
  ) => {
    setBusyKey(tpl.key);
    try {
      const t = await token();
      await adoptSkill({
        data: { accessToken: t, viewAsUserId, templateKey: tpl.key, source },
      });
      toast.success(`"${tpl.label}" added to your back office.`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't add the Skill.");
    } finally {
      setBusyKey(null);
    }
  };

  const dismiss = async (s: SuggestedSkill) => {
    setBusyKey(s.templateKey);
    try {
      const t = await token();
      await dismissSuggestion({
        data: { accessToken: t, viewAsUserId, templateKey: s.templateKey },
      });
      setSuggestions((prev) => prev.filter((x) => x.templateKey !== s.templateKey));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't dismiss.");
    } finally {
      setBusyKey(null);
    }
  };

  const toggle = async (s: AdoptedSkill) => {
    setBusyId(s.id);
    try {
      const t = await token();
      await setSkillEnabled({
        data: {
          accessToken: t,
          viewAsUserId,
          skillId: s.id,
          enabled: !s.enabled,
        },
      });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update the Skill.");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (s: AdoptedSkill) => {
    if (
      !window.confirm(
        `Remove "${s.name}" from your Skills? This won't delete the routine it set up — you can re-add it any time.`,
      )
    )
      return;
    setBusyId(s.id);
    try {
      const t = await token();
      await removeSkill({ data: { accessToken: t, viewAsUserId, skillId: s.id } });
      toast.success("Removed.");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove the Skill.");
    } finally {
      setBusyId(null);
    }
  };

  const loading = valueMoment === null || skills === null;
  const adopted = skills ?? [];
  const available = SKILL_CATALOG.filter((t) => !adoptedByKey.has(t.key));

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Your Skills"
        description="Routines SmartSpa runs for you — across every Solution. Add one from the catalog, make it yours, turn it off any time."
      />

      {loading ? (
        <div className="flex items-center gap-2 py-16 justify-center text-ink-soft text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading your Skills…
        </div>
      ) : !unlocked ? (
        <LockedState />
      ) : (
        <div className="space-y-8 pb-16">
          {/* ── Suggested for you (mined from your activity) ──────────── */}
          {suggestions.length > 0 && (
            <section>
              <SectionLabel>Suggested for you</SectionLabel>
              <div className="grid gap-3 sm:grid-cols-2">
                {suggestions.map((s) => (
                  <SuggestionCard
                    key={s.templateKey}
                    suggestion={s}
                    busy={busyKey === s.templateKey}
                    onAdopt={() =>
                      adopt({ key: s.templateKey, label: s.label }, "mined")
                    }
                    onDismiss={() => dismiss(s)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* ── Your Skills (adopted) ─────────────────────────────────── */}
          {adopted.length > 0 && (
            <section>
              <SectionLabel>Active in your back office</SectionLabel>
              <div className="grid gap-3 sm:grid-cols-2">
                {adopted.map((s) => (
                  <AdoptedCard
                    key={s.id}
                    skill={s}
                    busy={busyId === s.id}
                    onToggle={() => toggle(s)}
                    onRemove={() => remove(s)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* ── The catalog ───────────────────────────────────────────── */}
          <section>
            <SectionLabel>
              {adopted.length > 0 ? "Add another Skill" : "Add a Skill"}
            </SectionLabel>
            <div className="grid gap-3 sm:grid-cols-2">
              {available.map((tpl) => (
                <CatalogCard
                  key={tpl.key}
                  tpl={tpl}
                  busy={busyKey === tpl.key}
                  onAdopt={() => adopt(tpl)}
                />
              ))}
            </div>
            {available.length === 0 && (
              <div className="rounded-lg border border-rule bg-paper px-4 py-8 text-center text-sm text-ink-faint">
                You've added every available Skill. More are on the way.
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
      {children}
    </div>
  );
}

function SolutionBadge({ tpl }: { tpl: SkillTemplate }) {
  return (
    <span className="inline-flex items-center rounded-full border border-rule bg-rule-soft/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
      {skillSolutionLabel(tpl.solution)}
    </span>
  );
}

function AdoptedCard({
  skill,
  busy,
  onToggle,
  onRemove,
}: {
  skill: AdoptedSkill;
  busy: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const tpl = findSkillInCatalog(skill.templateKey);
  const manageTo =
    typeof skill.materializedRef?.manageTo === "string"
      ? (skill.materializedRef.manageTo as string)
      : tpl?.manageTo;
  return (
    <div className="flex flex-col rounded-xl border border-emerald/30 bg-emerald-soft/15 p-4">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-emerald-ink" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-[14px] font-semibold text-ink">
              {skill.name}
            </div>
            {tpl && <SolutionBadge tpl={tpl} />}
          </div>
          {tpl && (
            <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
              {tpl.description}
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 pt-3 border-t border-emerald/20">
        {/* Enable toggle */}
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          className={
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition disabled:opacity-50 " +
            (skill.enabled
              ? "bg-emerald text-paper hover:opacity-95"
              : "border border-rule bg-white text-ink-soft hover:text-ink")
          }
          title={skill.enabled ? "On — tap to pause" : "Paused — tap to turn on"}
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : skill.enabled ? (
            <Check className="h-3 w-3" />
          ) : null}
          {skill.enabled ? "On" : "Paused"}
        </button>

        {manageTo && (
          <Link
            to={manageTo}
            className="inline-flex items-center gap-1 rounded-full border border-rule bg-white px-2.5 py-1 text-[11px] font-medium text-ink-soft transition hover:text-ink"
          >
            <Settings2 className="h-3 w-3" />
            Manage
            <ArrowRight className="h-3 w-3" />
          </Link>
        )}

        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-ink-faint transition hover:text-rose disabled:opacity-50"
          title="Remove from your Skills"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function CatalogCard({
  tpl,
  busy,
  onAdopt,
}: {
  tpl: SkillTemplate;
  busy: boolean;
  onAdopt: () => void;
}) {
  const isLive = tpl.status === "live";
  return (
    <div
      className={
        "flex flex-col rounded-xl border bg-paper p-4 " +
        (isLive ? "border-rule" : "border-rule/60")
      }
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className={"text-[14px] font-semibold " + (isLive ? "text-ink" : "text-ink-soft")}>
            {tpl.label}
          </div>
          <SolutionBadge tpl={tpl} />
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
          {tpl.description}
        </p>
        <p className="mt-2 text-[11px] italic text-ink-faint">{tpl.liftHint}</p>
      </div>

      <div className="mt-3 flex items-center gap-2 pt-3 border-t border-rule/60">
        {isLive ? (
          <button
            type="button"
            onClick={onAdopt}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-full bg-emerald px-3 py-1.5 text-[12px] font-semibold text-paper shadow-sm transition hover:opacity-95 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Add to my back office
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-rule px-3 py-1.5 text-[12px] font-medium text-ink-faint">
            <Lock className="h-3 w-3" />
            Coming soon
          </span>
        )}
      </div>
    </div>
  );
}

function SuggestionCard({
  suggestion,
  busy,
  onAdopt,
  onDismiss,
}: {
  suggestion: SuggestedSkill;
  busy: boolean;
  onAdopt: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-amber-200 bg-amber-50/70 p-4">
      <div className="flex items-start gap-2">
        <Wand2 className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-[14px] font-semibold text-ink">{suggestion.label}</div>
            <span className="inline-flex items-center rounded-full border border-rule bg-white/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              {skillSolutionLabel(suggestion.solution)}
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
            {suggestion.reason}
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 pt-3 border-t border-amber-200">
        <button
          type="button"
          onClick={onAdopt}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-full bg-emerald px-3 py-1.5 text-[12px] font-semibold text-paper shadow-sm transition hover:opacity-95 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          Add to my back office
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium text-ink-faint transition hover:text-ink disabled:opacity-50"
          title="Dismiss this suggestion"
        >
          <X className="h-3 w-3" />
          Dismiss
        </button>
      </div>
    </div>
  );
}

function LockedState() {
  return (
    <div className="rounded-xl border border-rule bg-paper px-6 py-10 text-center">
      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-emerald-soft">
        <Sparkles className="h-5 w-5 text-emerald-ink" />
      </div>
      <h2 className="text-[16px] font-semibold text-ink">
        Your Skills unlock after your first win
      </h2>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-ink-soft">
        Once SmartSpa has earned its keep — your first verified recovered-revenue
        win — this is where you'll build the routines that run your back office
        for you. A wishlist of automations before you've felt the value would
        just be noise, so we keep it out of the way until then.
      </p>
      <Link
        to="/app/refill/recovery"
        className="mt-4 inline-flex items-center gap-1 rounded-full bg-emerald px-4 py-2 text-[13px] font-semibold text-paper shadow-sm transition hover:opacity-95"
      >
        See your recovery dashboard
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}
