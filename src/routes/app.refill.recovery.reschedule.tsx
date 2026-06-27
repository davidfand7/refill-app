/**
 * Reschedule Reminders — the action surface (v2.35.0, Slice 2).
 *
 * Lists the recent cancels/no-shows the operator chose to follow up (classified
 * by their own no-show rule, deduped per patient, minus anyone already nudged /
 * already rebooked / opted out), and drafts warm rebook nudges to the spa's
 * iMessage proxy for human review + send. The rule itself is set on the
 * Reminders page ("No-show definition" card).
 */

import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  CalendarClock,
  Loader2,
  Send,
  Phone,
  Mail,
  Settings2,
  AlertTriangle,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { EmptyPanel } from "@/components/EmptyPanel";
import { RefillSolutionTabs } from "@/components/refill/RefillSolutionTabs";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  listRescheduleTargets,
  draftRescheduleNudges,
  type RescheduleTargetsResult,
  type RescheduleTarget,
} from "@/server/reschedule.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/recovery/reschedule")({
  component: ReschedulePage,
});

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function KindBadge({ kind }: { kind: RescheduleTarget["kind"] }) {
  const isNoShow = kind === "no_show";
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
        isNoShow ? "bg-rose-soft text-rose" : "bg-amber-soft text-amber",
      )}
    >
      {isNoShow ? "No-show" : "Cancel"}
    </span>
  );
}

function ReschedulePage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [data, setData] = useState<RescheduleTargetsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [drafting, setDrafting] = useState(false);

  useEffect(() => {
    void supabase.auth
      .getSession()
      .then(({ data: s }) => setAccessToken(s.session?.access_token ?? null));
  }, []);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const res = await listRescheduleTargets({ data: { accessToken, viewAsUserId } });
      setData(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load reschedule targets.");
    } finally {
      setLoading(false);
    }
  }, [accessToken, viewAsUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function draft() {
    if (!accessToken) return;
    setDrafting(true);
    try {
      const res = await draftRescheduleNudges({ data: { accessToken, viewAsUserId } });
      if (res.error) {
        toast.error(res.error);
      } else {
        toast.success(
          `Staged ${res.drafted} rebook draft${res.drafted === 1 ? "" : "s"} to ${res.sentTo} — review & send in Messages.${
            res.skippedNoPhone ? ` (${res.skippedNoPhone} had no phone)` : ""
          }`,
        );
        await load();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't draft the nudges.");
    } finally {
      setDrafting(false);
    }
  }

  const targets = data?.targets ?? [];
  const fresh = targets.filter((t) => !t.nudgedAt);
  const nudgedList = targets.filter((t) => t.nudgedAt);

  return (
    <div>
      <PageHeader
        eyebrow="Refill"
        title="Reschedule Reminders"
        description="Win back the patients who cancelled or no-showed. SmartSpa drafts a warm rebook nudge for each — you review and send. Set your no-show rule on the Reminders page."
      />
      <RefillSolutionTabs active="reschedule" />

      <div className="px-6 lg:px-10 py-6 space-y-5 max-w-[960px] mx-auto">
        {/* Settings summary + link back to the rule */}
        {data && (
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-soft">
            <span
              className={cn(
                "rounded-full px-2.5 py-1 font-semibold",
                data.enabled ? "bg-emerald-soft text-emerald" : "bg-rule text-ink-faint",
              )}
            >
              {data.enabled ? "On" : "Off"}
            </span>
            <span>
              No-show rule: &lt;{data.noticeHours}h notice · last {data.lookbackDays} days ·{" "}
              {data.targetCancels && data.targetNoshows
                ? "cancels + no-shows"
                : data.targetCancels
                  ? "cancels only"
                  : data.targetNoshows
                    ? "no-shows only"
                    : "no classes selected"}
              {data.delayDays > 0 && <> · {data.delayDays}-day grace</>}
            </span>
            <Link
              to="/app/refill/recovery/preshow"
              className="inline-flex items-center gap-1 font-semibold text-emerald hover:opacity-80"
            >
              <Settings2 className="h-3.5 w-3.5" />
              Change the rule
            </Link>
          </div>
        )}

        {/* Guard banners */}
        {data && !data.enabled && (
          <Banner tone="muted">
            Reschedule Reminders is off. Turn it on in{" "}
            <Link to="/app/refill/recovery/preshow" className="font-semibold underline">
              Reminders → No-show definition
            </Link>{" "}
            to draft nudges.
          </Banner>
        )}
        {data?.enabled && data.sendingPaused && (
          <Banner tone="warn">
            Sending is paused for your spa — resume it (Skills page) before drafting nudges.
          </Banner>
        )}
        {data?.enabled && !data.hasProxyEmail && (
          <Banner tone="warn">
            No iMessage proxy email set, so there&rsquo;s nowhere for drafts to land. Add one in
            your no-show settings.
          </Banner>
        )}

        {/* Action bar */}
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm text-ink">
            {loading ? (
              <span className="inline-flex items-center gap-1.5 text-ink-soft">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </span>
            ) : (
              <>
                <strong>{fresh.length}</strong> patient{fresh.length === 1 ? "" : "s"} to win back
                {data && data.reachable !== fresh.length && (
                  <span className="text-ink-faint"> · {data.reachable} reachable by text</span>
                )}
                {data && data.heldInGrace > 0 && (
                  <span className="text-ink-faint">
                    {" "}
                    · {data.heldInGrace} still in their grace window
                  </span>
                )}
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => void draft()}
            disabled={
              drafting ||
              loading ||
              !data?.enabled ||
              !data?.hasProxyEmail ||
              data?.sendingPaused ||
              (data?.reachable ?? 0) === 0
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-4 py-2 text-sm font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
          >
            {drafting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Draft rebook nudges
          </button>
        </div>

        {/* Empty state — distinguishes "nobody at all" from "all caught up". */}
        {!loading && fresh.length === 0 &&
          (nudgedList.length > 0 ? (
            <EmptyPanel
              icon={CalendarClock}
              title="All caught up"
              description="Everyone eligible has been nudged. They stay below until they rebook or the window passes."
            />
          ) : (
            <EmptyPanel
              icon={CalendarClock}
              title="Nobody to win back right now"
              description="Recent cancels and no-shows who haven’t already rebooked or been nudged will appear here. Widen the rule to catch more of them."
              cta={{
                label: "Adjust the win-back rule",
                icon: Settings2,
                to: "/app/refill/recovery/preshow",
              }}
            />
          ))}

        {/* To win back (actionable) */}
        {fresh.length > 0 && (
          <ul className="space-y-1.5">
            {fresh.map((t) => (
              <TargetRow key={t.targetKey} t={t} />
            ))}
          </ul>
        )}

        {/* Recently nudged (greyed, kept for continuity — never silently hidden) */}
        {nudgedList.length > 0 && (
          <div className="pt-1">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
              Recently nudged · {nudgedList.length}
            </div>
            <ul className="space-y-1.5">
              {nudgedList.map((t) => (
                <TargetRow key={t.targetKey} t={t} nudged />
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function TargetRow({ t, nudged }: { t: RescheduleTarget; nudged?: boolean }) {
  const reachable = Boolean((t.phone ?? "").trim());
  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded-lg border border-rule bg-white px-3 py-2.5 text-[13px]",
        nudged && "opacity-60",
      )}
    >
      <span className="font-medium text-ink">{t.name || "(unnamed)"}</span>
      <KindBadge kind={t.kind} />
      {t.patientNodeId === null && (
        <span
          className="rounded-full bg-rule px-2 py-0.5 text-[10.5px] font-semibold text-ink-soft"
          title="No profile yet — reachable via the contact on their booking"
        >
          New patient
        </span>
      )}
      {t.treatmentType && <span className="text-ink-faint">· {t.treatmentType}</span>}
      <span className="text-ink-faint">· {fmtWhen(t.scheduledAt)}</span>
      <div className="ml-auto flex items-center gap-2 text-ink-faint">
        {nudged && t.nudgedAt ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald">
            <Send className="h-3 w-3" /> nudged {fmtWhen(t.nudgedAt)}
          </span>
        ) : reachable ? (
          <Phone className="h-3.5 w-3.5 text-emerald" />
        ) : t.email ? (
          <Mail className="h-3.5 w-3.5" />
        ) : (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-amber"
            title="No phone — can't text"
          >
            <AlertTriangle className="h-3.5 w-3.5" /> no phone
          </span>
        )}
      </div>
    </li>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "muted" | "warn";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3 text-[13px]",
        tone === "warn"
          ? "border-amber/30 bg-amber-soft/40 text-amber"
          : "border-rule bg-paper/40 text-ink-soft",
      )}
    >
      {children}
    </div>
  );
}
