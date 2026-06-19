/**
 * Shared Recognition sub-nav (Patient-Profitability OS).
 *
 * One tab strip, four tabs: Inventory / Manufacturers / Rewards / Recall.
 * Previously inlined three different ways across the three route files —
 * extracted here (2026-06-07, P1 Recall) so a new tab is a one-line add
 * instead of a four-file edit that drifts.
 */

import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Gift, Layers, PhoneOutgoing, Wand2, Target, Tag } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { getRewardExpiryBadge } from "@/server/refill-recall.functions";

/**
 * Reward-Expiry Sweep (the 'surface' materializer): an ambient badge of rewards
 * expiring soon, pinned on the Recall tab. Self-fetching + best-effort — only
 * renders when the Skill is adopted + on AND there's expiring money. A miss
 * never breaks the tab strip.
 */
function RecallExpiryBadge() {
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
        setBadge(r.enabled && r.count > 0 ? { count: r.count, dollars: r.dollars } : null);
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
      title={`$${badge.dollars.toLocaleString()} in rewards expiring within 60 days — open Recall`}
      className="ml-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums"
      style={{ background: "#fef3c7", color: "#92400e" }}
    >
      {badge.count}
    </span>
  );
}

// "brand-promos" retired v2.94 — the rep-interest loop folded into the Rewards
// offers surface (RepPromosCard, gated by rep_loop_enabled). The standalone
// route now redirects to Rewards. Kept in the union so a stale `active` prop
// (and the redirecting route, if it ever renders) still type-checks.
export type RecognitionTab =
  | "brand-promos"
  | "inventory"
  | "rewards"
  | "offers"
  | "program"
  | "recall"
  | "allocation";

const TABS: Array<{
  key: RecognitionTab;
  to: string;
  label: string;
  Icon: typeof Layers;
}> = [
  { key: "inventory", to: "/app/refill/recognition/inventory", label: "Inventory", Icon: Layers },
  { key: "rewards", to: "/app/refill/recognition/rewards", label: "Rewards", Icon: Gift },
  { key: "offers", to: "/app/refill/recognition/offers", label: "Offers", Icon: Tag },
  { key: "program", to: "/app/refill/recognition/program", label: "Program", Icon: Target },
  { key: "recall", to: "/app/refill/recognition/recall", label: "Recall", Icon: PhoneOutgoing },
  { key: "allocation", to: "/app/refill/recognition/allocation", label: "Allocation", Icon: Wand2 },
];

export function RecognitionTabs({ active }: { active: RecognitionTab }) {
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
            {key === "recall" && <RecallExpiryBadge />}
          </Link>
        ))}
      </div>
    </div>
  );
}
