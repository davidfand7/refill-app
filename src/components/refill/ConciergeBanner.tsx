/**
 * ConciergeBanner — the honest "a human is co-driving your setup" marker
 * (project_trusted_onboarding: concierge is a SETTING, not a phase).
 *
 * Self-contained (fetches its own state, like WishlistWidget) so the shell
 * stays presentational. Shows ONLY when this tenant's `concierge_mode_enabled`
 * flag is on — an admin flips it per spa during white-glove onboarding and off
 * once they self-drive. It forks no behavior: same gates, same rails — this is
 * purely the transparency that an operator is riding alongside the owner.
 * Honesty is the moat; the owner should always know who's driving.
 */
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { getConciergeState } from "@/server/concierge.functions";

export function ConciergeBanner() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;
  const hasTenant = membership.status === "tenant";

  const [conciergeMode, setConciergeMode] = useState(false);

  useEffect(() => {
    if (!hasTenant) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return;
        const { conciergeMode: on } = await getConciergeState({
          data: { accessToken: token, viewAsUserId },
        });
        if (!cancelled) setConciergeMode(on);
      } catch {
        // Banner is informational — a transient read failure just leaves it
        // hidden; it re-checks on remount. Never block the shell on it.
        if (!cancelled) setConciergeMode(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasTenant, viewAsUserId]);

  if (!conciergeMode) return null;

  return (
    <div
      className="mb-3 rounded-lg border px-3 py-2 text-[12px] flex items-center gap-2"
      style={{
        background: "#e8f1ed",
        borderColor: "rgba(5, 96, 72, 0.3)",
        color: "#056048",
      }}
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0" />
      <span>
        <strong>Your SmartSpa team is setting this up with you.</strong> A
        person is co-driving your onboarding right now &mdash; you&rsquo;re on
        the exact same SmartSpa as everyone else, just with a hand on your
        shoulder while it gets going. Anything you do here sticks; you can take
        the wheel any time.
      </span>
    </div>
  );
}
