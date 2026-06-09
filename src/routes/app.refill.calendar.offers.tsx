/**
 * /app/refill/calendar/offers — Cross-sell offers, surfaced as a tab in the
 * Calendar Solution (v2.3.7). The owner-authored cross-sell offers badge a
 * service AT booking, so the booking/calendar surface is a natural second home
 * for them (they also live in Promos → Reward signals). Same SpaOffersCard, same
 * data — one room, two doors.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/PageHeader";
import { CalendarTabs } from "@/components/refill/CalendarTabs";
import { SpaOffersCard } from "@/components/refill/SpaOffersCard";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";

export const Route = createFileRoute("/app/refill/calendar/offers")({
  component: CalendarOffersPage,
});

function CalendarOffersPage() {
  const membership = useTenantMembership();
  const viewAsUserId = membership.status === "tenant" ? membership.viewAsUserId : undefined;
  const [accessToken, setAccessToken] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { data: sess } = await supabase.auth.getSession();
      setAccessToken(sess.session?.access_token ?? null);
    })();
  }, []);

  return (
    <div>
      <PageHeader
        eyebrow="Calendar"
        title="Cross-sell"
        description="Author your own at-booking upsells — pick a service, set a discount, and it badges that service on your booking page. Earns $5 when a matched patient books it."
      />
      <CalendarTabs active="offers" />

      <div className="px-6 lg:px-10 py-6 max-w-[760px] mx-auto">
        <SpaOffersCard accessToken={accessToken} viewAsUserId={viewAsUserId} />
      </div>
    </div>
  );
}
