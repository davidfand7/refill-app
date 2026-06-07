/**
 * /app/refill/sharing — Patient Architecture P4 spa-controlled consent surface.
 *
 * The spa owner sees every rep they've expressed interest with via a
 * promotion, and can toggle "share aggregates" per rep. Default is off.
 * Sharing is aggregate-only — counts per manufacturer, overdue totals,
 * loyalty engagement — NEVER patient names or rows. The typed boundary in
 * spa-rep-data-share.functions.ts enforces that at the type level.
 *
 * Empty state: when the spa hasn't engaged with any rep promos yet, the
 * page explains the relationship model and points back to /app/refill/promos
 * to start. We don't preemptively list reps the spa doesn't know about.
 *
 * Established 2026-05-15 (Patient Architecture P4).
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/integrations/supabase/client";
import {
  grantRepDataShare,
  listSpaShareableReps,
  revokeRepDataShare,
  type SpaShareableRep,
} from "@/server/spa-rep-data-share.functions";

export const Route = createFileRoute("/app/refill/sharing")({
  component: SharingPage,
});

function SharingPage() {
  const [reps, setReps] = useState<SpaShareableRep[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setError("Please sign in to manage sharing.");
        return;
      }
      const list = await listSpaShareableReps({
        data: { accessToken: token },
      });
      setReps(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load rep relationships.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleShare(rep: SpaShareableRep) {
    setBusyId(rep.repUserId);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Sign-in lost — refresh and try again.");
        return;
      }
      if (rep.isSharing) {
        await revokeRepDataShare({
          data: { accessToken: token, repUserId: rep.repUserId },
        });
        toast.success(`Stopped sharing aggregates with ${rep.repDisplayName}.`);
      } else {
        await grantRepDataShare({
          data: { accessToken: token, repUserId: rep.repUserId },
        });
        toast.success(`Now sharing aggregates with ${rep.repDisplayName}.`);
      }
      // Optimistic flip pending the reload.
      setReps(
        (prev) =>
          prev?.map((r) =>
            r.repUserId === rep.repUserId
              ? { ...r, isSharing: !r.isSharing }
              : r,
          ) ?? null,
      );
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update sharing.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Emma(OS) · Sharing"
        title="Rep aggregates"
        description="Let specific reps see aggregate counts from your patient book. Patient names and details never leave your practice."
      />
      <div className="px-6 lg:px-10 py-8 max-w-[1600px] mx-auto space-y-5">
        <PrivacyExplainer />
        {reps === null && !error && (
          <div className="rounded-2xl border border-border bg-card p-10 flex items-center justify-center gap-2 text-sm text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading rep relationships…
          </div>
        )}
        {error && (
          <EmptyState
            icon={AlertCircle}
            title="Couldn't load reps"
            description={error}
          />
        )}
        {reps !== null && reps.length === 0 && (
          <div className="rounded-2xl border border-border bg-card p-10 text-center space-y-3">
            <div className="mx-auto h-12 w-12 rounded-2xl bg-emerald/10 flex items-center justify-center">
              <Users className="h-5 w-5 text-emerald" />
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">No rep relationships yet</h2>
              <p className="text-sm text-ink-soft max-w-md mx-auto leading-relaxed">
                Once you tap "I'm interested" on a promo from your{" "}
                <Link to="/app/refill/promos" className="text-emerald hover:underline">
                  eligible promos
                </Link>{" "}
                page, that rep will show up here. You can then choose what — if
                anything — to share with them.
              </p>
            </div>
          </div>
        )}
        {reps !== null && reps.length > 0 && (
          <div className="rounded-2xl border border-border bg-card overflow-hidden divide-y divide-border">
            {reps.map((rep) => (
              <RepRow
                key={rep.repUserId}
                rep={rep}
                busy={busyId === rep.repUserId}
                onToggle={() => void toggleShare(rep)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PrivacyExplainer() {
  return (
    <section className="rounded-2xl border border-emerald-500/20 bg-emerald-50/40 dark:bg-emerald-950/15 p-5">
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-lg bg-emerald-500/15 flex items-center justify-center shrink-0">
          <ShieldCheck className="h-4 w-4 text-emerald-700 dark:text-emerald-300" />
        </div>
        <div className="flex-1 text-xs text-ink-soft leading-relaxed">
          <div className="text-sm font-semibold text-foreground mb-1">
            What's shared, what isn't
          </div>
          <ul className="list-disc list-inside space-y-0.5">
            <li>
              <strong>Shared (when toggled on):</strong> counts only — "84
              active Jeuveau patients", "21 lapsed fillers", manufacturer mix
              percentages.
            </li>
            <li>
              <strong>Never shared:</strong> patient names, phone, email,
              individual visit history, lifetime spend per patient.
            </li>
          </ul>
          <p className="mt-2">
            You control this per rep. Revoke any time — they stop seeing
            aggregates immediately.
          </p>
        </div>
      </div>
    </section>
  );
}

function RepRow({
  rep,
  busy,
  onToggle,
}: {
  rep: SpaShareableRep;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="px-5 py-4 flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold">{rep.repDisplayName}</span>
          {rep.isSharing ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
              <CheckCircle2 className="h-2.5 w-2.5" />
              Sharing
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted text-ink-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
              Not shared
            </span>
          )}
        </div>
        {rep.repEmail && (
          <div className="text-[11px] text-ink-soft mt-0.5">{rep.repEmail}</div>
        )}
        {rep.knownPromotions.length > 0 && (
          <div className="text-[11px] text-ink-faint mt-1.5 flex items-center gap-1.5 flex-wrap">
            <Sparkles className="h-3 w-3" />
            Promos you engaged with:{" "}
            {rep.knownPromotions.slice(0, 2).join(" · ")}
            {rep.knownPromotions.length > 2 &&
              ` · +${rep.knownPromotions.length - 2} more`}
          </div>
        )}
      </div>
      <div className="shrink-0">
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          className={
            "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 " +
            (rep.isSharing
              ? "border border-border bg-background text-ink-soft hover:bg-muted hover:text-foreground"
              : "bg-emerald text-paper hover:opacity-90")
          }
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : rep.isSharing ? (
            "Stop sharing"
          ) : (
            "Share aggregates"
          )}
        </button>
      </div>
    </div>
  );
}
