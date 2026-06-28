/**
 * Rewards sub-nav (v2.200.0) — the patient-side of the manufacturer
 * relationship (project_buying_rewards_taxonomy).
 *   • Rewards = manufacturer→patient loyalty (Allē-style) + reward-signal
 *     exports/attribution. Route stays /recognition/rewards.
 *   • Offers  = the spa's OWN promos to patients. Route stays /recognition/offers.
 *   • Renew   = recall of lapsed/overdue patients — the loved word finally
 *     gets its home (closes project_terms_meaning_sweep). Route stays
 *     /recognition/recall (was a redirect; now the real Renew page).
 * The reward-expiry badge (rewards expiring within 60 days → recall) rides the
 * Renew tab, where the action lives.
 */

import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Gift, Tag, RefreshCw } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { getRewardExpiryBadge } from "@/server/refill-recall.functions";

/**
 * Reward-Expiry Sweep badge: ambient count of rewards expiring soon, pinned on
 * the Renew tab. Self-fetching + best-effort — only renders when the Skill is
 * adopted + on AND there's expiring money. A miss never breaks the tab strip.
 */
function RenewExpiryBadge() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;
  const [badge, setBadge] = useState<{ count: number; dollars: number } | null>(
    null,
  );

  useEffect(() => {
    if (membership.status === "loading") return;
    let cancelled = false;
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return;
        const r = await getRewardExpiryBadge({
          data: { accessToken: token, viewAsUserId },
        });
        if (cancelled) return;
        setBadge(
          r.enabled && r.count > 0 ? { count: r.count, dollars: r.dollars } : null,
        );
      } catch {
        /* badge is best-effort — never break the tabs */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [membership.status, viewAsUserId]);

  if (!badge) return null;
  return (
    <span
      title={`$${badge.dollars.toLocaleString()} in rewards expiring within 60 days — open Renew`}
      className="ml-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums"
      style={{ background: "#fef3c7", color: "#92400e" }}
    >
      {badge.count}
    </span>
  );
}

export type RewardsTab = "rewards" | "offers" | "renew";

const TABS: Array<{
  key: RewardsTab;
  to: string;
  label: string;
  Icon: typeof Gift;
}> = [
  { key: "rewards", to: "/app/refill/recognition/rewards", label: "Rewards", Icon: Gift },
  { key: "offers", to: "/app/refill/recognition/offers", label: "Offers", Icon: Tag },
  { key: "renew", to: "/app/refill/recognition/recall", label: "Renew", Icon: RefreshCw },
];

export function RewardsTabs({ active }: { active: RewardsTab }) {
  return (
    <div className="border-b border-rule bg-paper/50">
      <div className="max-w-[960px] mx-auto px-4 lg:px-10 flex items-center gap-1">
        {TABS.map(({ key, to, label, Icon }) => (
          <Link
            key={key}
            to={to}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px transition"
            style={{
              borderColor: active === key ? "#056048" : "transparent",
              color: active === key ? "#056048" : "#5a6068",
            }}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
            {key === "renew" && <RenewExpiryBadge />}
          </Link>
        ))}
      </div>
    </div>
  );
}
