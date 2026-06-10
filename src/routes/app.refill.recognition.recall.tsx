/**
 * /app/refill/recognition/recall — Recall (Patient-Profitability OS · P1).
 *
 * Slice A: the surface — four trigger lists (Expiring · Eligible & idle ·
 * Becoming-eligible · Lapsed) under a twin headline.
 *
 * Slice B (this file now): the action.
 *   • Select matched patients → Draft outreach → one email of READY-TO-SEND
 *     iMessage drafts to the spa's drafts inbox (Claude Desktop + iMessage MCP
 *     → blue bubble from the spa's own Apple ID).
 *   • Book a patient straight from a row (prefilled BookDialog) → records a
 *     $5 recall_booking win on the fee-rules ledger (verified later when the
 *     patient actually pays).
 *
 * Only MATCHED targets (in your patient book) can be drafted/booked — an
 * unmatched reward patient has no phone-to-graph link and no node to attribute
 * the win to.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlarmClock,
  CalendarClock,
  CalendarPlus,
  Loader2,
  Moon,
  PhoneOutgoing,
  Send,
  Sparkles,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { RecognitionTabs } from "@/components/refill/RecognitionTabs";
import { BookDialog } from "@/components/refill/schedule/dialogs";
import { todayIso, type ServiceLite } from "@/components/refill/schedule/shared";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  getDayScheduleFn,
  type ProviderLite,
} from "@/server/scheduling-owner.functions";
import {
  listRecallTargets,
  draftRecallOutreachFn,
  type RecallView,
  type RecallGroup,
  type RecallTarget,
  type RecallTrigger,
} from "@/server/refill-recall.functions";

export const Route = createFileRoute("/app/refill/recognition/recall")({
  component: RecallPage,
});

const TRIGGER_META: Record<
  RecallTrigger,
  { Icon: typeof AlarmClock; blurb: string }
> = {
  expiring: {
    Icon: AlarmClock,
    blurb: "Reward expires within 60 days — book them before it evaporates.",
  },
  eligible_idle: {
    Icon: Sparkles,
    blurb: "Eligible to redeem now, but hasn't been in for 90+ days.",
  },
  becoming_eligible: {
    Icon: CalendarClock,
    blurb: "Reward unlocks soon — pre-position the outreach.",
  },
  lapsed: {
    Icon: Moon,
    blurb: "Past the lapse window for their primary treatment cadence.",
  },
};

type BookingContext = {
  services: ServiceLite[];
  providers: ProviderLite[];
  providerUnoffered: Record<string, string[]>;
  tenantId: string;
  timezone: string;
};

function RecallPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [view, setView] = useState<RecallView | null>(null);
  const [ctx, setCtx] = useState<BookingContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState<RecallTrigger>("expiring");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drafting, setDrafting] = useState(false);
  const [bookTarget, setBookTarget] = useState<RecallTarget | null>(null);

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setLoadError("Please sign in.");
        return;
      }
      const [v, day] = await Promise.all([
        listRecallTargets({ data: { accessToken: token, viewAsUserId } }),
        // Booking context for the prefilled BookDialog (today's view; we only
        // need its services/providers/tenant/tz, not the appointments).
        getDayScheduleFn({
          data: { accessToken: token, viewAsUserId, dateIso: todayIso() },
        }).catch(() => null),
      ]);
      setView(v);
      if (day) {
        setCtx({
          services: day.services,
          providers: day.providers,
          providerUnoffered: day.providerUnoffered,
          tenantId: day.tenantId,
          timezone: day.timezone,
        });
      }
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load.");
    } finally {
      setLoading(false);
    }
  }, [viewAsUserId]);

  useEffect(() => {
    if (membership.status === "loading") return;
    void load();
  }, [membership.status, load]);

  const groups = view?.groups ?? [];
  const activeGroup = groups.find((g) => g.trigger === active);

  // Flatten selected → the target objects (across all groups) for the draft fn.
  const selectedTargets = useMemo(() => {
    if (selected.size === 0) return [];
    const all = groups.flatMap((g) => g.targets);
    return all.filter((t) => selected.has(t.key));
  }, [selected, groups]);

  function toggle(key: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }

  function toggleAllInActive() {
    const bookable = (activeGroup?.targets ?? []).filter((t) => t.matched && t.phone);
    const allSelected = bookable.length > 0 && bookable.every((t) => selected.has(t.key));
    setSelected((prev) => {
      const n = new Set(prev);
      if (allSelected) bookable.forEach((t) => n.delete(t.key));
      else bookable.forEach((t) => n.add(t.key));
      return n;
    });
  }

  async function draftSelected() {
    if (selectedTargets.length === 0) return;
    setDrafting(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const r = await draftRecallOutreachFn({
        data: {
          accessToken: token,
          viewAsUserId,
          targets: selectedTargets.map((t) => ({
            fullName: t.patientName ?? "Patient",
            phone: t.phone,
            brand: t.brandProduct,
            trigger: t.trigger,
            expirationDate: t.expirationDate,
            eligibleDate: t.eligibleDate,
          })),
        },
      });
      if (r.sent) {
        toast.success(
          `${r.drafted} draft${r.drafted === 1 ? "" : "s"} emailed to ${r.sentTo} — paste into Claude Desktop to send.`,
        );
        setSelected(new Set());
      } else {
        toast.error(r.error ?? "Couldn't send drafts.");
      }
      if (r.skippedNoPhone.length > 0) {
        toast.message(
          `${r.skippedNoPhone.length} skipped (no phone): ${r.skippedNoPhone.slice(0, 3).join(", ")}${r.skippedNoPhone.length > 3 ? "…" : ""}`,
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send drafts.");
    } finally {
      setDrafting(false);
    }
  }

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <PageHeader
        title="Recall"
        eyebrow="Promos"
        description="Lapsed patients and expiring rewards, surfaced as money on the table. Each name is a patient the manufacturer would otherwise send to “a provider near you” — book them into your own chair instead."
        breadcrumbs={[
          { label: "Refill", to: "/app/refill" },
          { label: "Promos", to: "/app/refill/recognition/inventory" },
          { label: "Recall" },
        ]}
      />

      <RecognitionTabs active="recall" />

      <div className="flex-1 px-4 py-6 lg:px-10 max-w-[960px] w-full mx-auto space-y-5">
        {loadError ? (
          <div className="rounded-2xl border border-rose/30 bg-rose-soft p-5 text-sm">
            <div className="font-semibold text-rose">Couldn't load</div>
            <p className="text-xs text-ink-soft mt-1">{loadError}</p>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center text-sm text-ink-soft py-16">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading…
          </div>
        ) : !view || view.distinctPatients === 0 ? (
          <EmptyState />
        ) : (
          <>
            {/* Twin headline */}
            <div className="rounded-2xl border border-rule bg-paper/30 px-5 py-4 flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                  On the table
                </div>
                <div className="text-3xl font-bold tabular-nums text-emerald-ink">
                  ${Math.round(view.dollarsOnTable).toLocaleString()}
                </div>
              </div>
              <div className="text-ink-faint text-2xl font-light">·</div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                  Patients to recall
                </div>
                <div className="text-3xl font-bold tabular-nums text-ink">
                  {view.distinctPatients.toLocaleString()}
                </div>
              </div>
              <p className="text-[11px] text-ink-faint ml-auto max-w-[34ch]">
                Reward dollars across expiring + eligible-&-idle, across every
                patient in all four triggers.
              </p>
            </div>

            {/* Trigger selector */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {groups.map((g) => (
                <TriggerCard
                  key={g.trigger}
                  group={g}
                  selected={active === g.trigger}
                  onClick={() => setActive(g.trigger)}
                />
              ))}
            </div>

            {/* Selection action bar */}
            {selected.size > 0 && (
              <div className="sticky top-2 z-10 flex flex-wrap items-center gap-3 rounded-2xl border border-emerald/30 bg-emerald-soft/70 px-4 py-2.5 backdrop-blur">
                <span className="text-[13px] font-semibold text-emerald-ink">
                  {selected.size} selected
                </span>
                <button
                  type="button"
                  onClick={draftSelected}
                  disabled={drafting}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-3.5 py-1.5 text-[12px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
                >
                  {drafting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  Draft outreach
                </button>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="text-[12px] text-ink-soft hover:text-ink"
                >
                  Clear
                </button>
              </div>
            )}

            {/* Active list */}
            {activeGroup && (
              <TargetList
                group={activeGroup}
                selected={selected}
                onToggle={toggle}
                onToggleAll={toggleAllInActive}
                onBook={(t) => setBookTarget(t)}
                canBook={!!ctx}
              />
            )}
          </>
        )}
      </div>

      {ctx && (
        <BookDialog
          open={!!bookTarget}
          onClose={() => setBookTarget(null)}
          services={ctx.services}
          providers={ctx.providers}
          providerUnoffered={ctx.providerUnoffered}
          tenantId={ctx.tenantId}
          timezone={ctx.timezone}
          initialDate={todayIso()}
          initialTime="09:00"
          initialName={bookTarget?.patientName ?? undefined}
          initialEmail={bookTarget?.email ?? undefined}
          initialPhone={bookTarget?.phone ?? undefined}
          recallPatientNodeId={bookTarget?.patientNodeId ?? undefined}
          viewAsUserId={viewAsUserId}
          onBooked={() => {
            setBookTarget(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function TriggerCard({
  group,
  selected,
  onClick,
}: {
  group: RecallGroup;
  selected: boolean;
  onClick: () => void;
}) {
  const Icon = TRIGGER_META[group.trigger].Icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-2xl px-4 py-3 text-left transition hover:shadow-sm"
      style={{
        background: selected ? "#fff" : "#fbfaf7",
        border: `1px solid ${selected ? "#056048" : "#e6e2d6"}`,
        boxShadow: selected ? "inset 0 0 0 1px #056048" : "none",
      }}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        <Icon className="h-3.5 w-3.5" />
        {group.label}
      </div>
      <div className="text-2xl font-bold tabular-nums mt-0.5 text-ink">
        {group.patients.toLocaleString()}
      </div>
      <div className="text-[11px] text-ink-faint">
        {group.dollars > 0
          ? `$${Math.round(group.dollars).toLocaleString()} in rewards`
          : "patients"}
      </div>
    </button>
  );
}

function TargetList({
  group,
  selected,
  onToggle,
  onToggleAll,
  onBook,
  canBook,
}: {
  group: RecallGroup;
  selected: Set<string>;
  onToggle: (key: string) => void;
  onToggleAll: () => void;
  onBook: (t: RecallTarget) => void;
  canBook: boolean;
}) {
  const meta = TRIGGER_META[group.trigger];
  if (group.targets.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-rule bg-paper/30 p-8 text-center text-sm text-ink-soft">
        No patients in <span className="font-semibold">{group.label}</span> right now.
      </div>
    );
  }
  const bookable = group.targets.filter((t) => t.matched && t.phone);
  const allSelected =
    bookable.length > 0 && bookable.every((t) => selected.has(t.key));
  return (
    <div className="space-y-2">
      <p className="text-[12px] text-ink-soft">{meta.blurb}</p>
      <div className="rounded-2xl border border-rule bg-white overflow-hidden">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-rule bg-paper/40 text-left">
              <th className="px-3 py-2 w-9">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={onToggleAll}
                  disabled={bookable.length === 0}
                  className="h-3.5 w-3.5 accent-emerald cursor-pointer disabled:cursor-default"
                />
              </th>
              <Th>Patient</Th>
              <Th>Brand</Th>
              <Th>{group.trigger === "lapsed" ? "Overdue" : "Reward"}</Th>
              <Th>
                {group.trigger === "expiring"
                  ? "Expires"
                  : group.trigger === "becoming_eligible"
                    ? "Eligible"
                    : "Last visit"}
              </Th>
              <th className="px-3 py-2 w-20" />
            </tr>
          </thead>
          <tbody>
            {group.targets.slice(0, 500).map((t) => (
              <TargetRow
                key={t.key}
                t={t}
                checked={selected.has(t.key)}
                onToggle={() => onToggle(t.key)}
                onBook={() => onBook(t)}
                canBook={canBook}
              />
            ))}
          </tbody>
        </table>
        {group.targets.length > 500 && (
          <div className="px-4 py-2 text-[11px] text-ink-faint border-t border-rule">
            Showing first 500 of {group.targets.length.toLocaleString()}.
          </div>
        )}
      </div>
    </div>
  );
}

function TargetRow({
  t,
  checked,
  onToggle,
  onBook,
  canBook,
}: {
  t: RecallTarget;
  checked: boolean;
  onToggle: () => void;
  onBook: () => void;
  canBook: boolean;
}) {
  const actionable = t.matched && !!t.phone;
  const dateCol =
    t.trigger === "expiring"
      ? fmtDate(t.expirationDate)
      : t.trigger === "becoming_eligible"
        ? fmtDate(t.eligibleDate)
        : fmtDate(t.lastVisit);
  const thirdCol =
    t.trigger === "lapsed"
      ? t.daysIdle != null
        ? `${t.daysIdle}d`
        : "—"
      : t.rewardAmountUsd != null
        ? `$${Math.round(t.rewardAmountUsd).toLocaleString()}`
        : "—";
  return (
    <tr className="border-b border-rule/60 last:border-0 hover:bg-paper/30">
      <td className="px-3 py-2">
        <input
          type="checkbox"
          aria-label={`Select ${t.patientName ?? "patient"}`}
          checked={checked}
          onChange={onToggle}
          disabled={!actionable}
          className="h-3.5 w-3.5 accent-emerald cursor-pointer disabled:cursor-default disabled:opacity-30"
        />
      </td>
      <td className="px-3 py-2">
        <div className="font-medium text-ink">{t.patientName ?? "—"}</div>
        {!t.matched ? (
          <span className="text-[10px] text-amber">not in your book</span>
        ) : !t.phone ? (
          <span className="text-[10px] text-ink-faint">no phone on file</span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-ink-soft">{t.brandProduct ?? "—"}</td>
      <td className="px-3 py-2 text-ink-soft tabular-nums">{thirdCol}</td>
      <td className="px-3 py-2 text-ink-soft tabular-nums">{dateCol}</td>
      <td className="px-3 py-2 text-right">
        {t.matched && (
          <button
            type="button"
            onClick={onBook}
            disabled={!canBook}
            title={canBook ? "Book this patient" : "Loading scheduler…"}
            className="inline-flex items-center gap-1 rounded-lg border border-emerald/40 px-2.5 py-1 text-[11px] font-semibold text-emerald-ink hover:bg-emerald-soft transition disabled:opacity-40"
          >
            <CalendarPlus className="h-3 w-3" />
            Book
          </button>
        )}
      </td>
    </tr>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
      {children}
    </th>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-rule bg-paper/30 p-10 text-center">
      <div className="h-12 w-12 mx-auto rounded-full bg-emerald-soft text-emerald-ink flex items-center justify-center mb-3">
        <PhoneOutgoing className="h-6 w-6" />
      </div>
      <h2 className="text-base font-semibold text-ink mb-1">Nobody to recall yet</h2>
      <p className="text-sm text-ink-soft max-w-md mx-auto">
        Once you import a manufacturer rewards export (Recognition → Rewards) or
        your patient history builds a cadence, the patients worth calling back —
        expiring rewards and lapsed regulars — surface here.
      </p>
    </div>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${m}/${d}/${y.slice(2)}`;
}
