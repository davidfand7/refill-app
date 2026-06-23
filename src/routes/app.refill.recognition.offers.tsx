/**
 * /app/refill/recognition/offers — the unified Offer engine (v2.104).
 *
 * Offers get their own home. The authoring surfaces used to live buried on the
 * Rewards tab next to manufacturer reward-tracking; they're now a dedicated
 * sub-tab so the composer is the hero of its own page (project_agentic_native_
 * authoring — "Offers" is the one surface to author + deliver an offer).
 *
 * Hosts: the unified OfferComposer (author your own offer or deliver a
 * manufacturer promo, single or A/B as one intent) + the two result lists it
 * feeds ("Your offers" / "Your tests"). Reward tracking, attribution, and the
 * manufacturer-promo CSV feed stay on the Rewards tab.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { PageHeader } from "@/components/PageHeader";
import { RecognitionTabs } from "@/components/refill/RecognitionTabs";
import { OfferComposer } from "@/components/refill/OfferComposer";
import { SpaOffersCard } from "@/components/refill/SpaOffersCard";
import { SmartAbCard } from "@/components/refill/SmartAbCard";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";

export const Route = createFileRoute("/app/refill/recognition/offers")({
  component: OffersPage,
});

function OffersPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped when the composer creates an offer/test, so the two result lists
  // (Your offers / Your tests) re-fetch.
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setLoadError("Please sign in.");
        return;
      }
      setAccessToken(token);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load.");
    }
  }, []);

  useEffect(() => {
    if (membership.status === "loading") return;
    void load();
  }, [membership.status, load]);

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <PageHeader
        title="Offers"
        eyebrow="Incentives"
        description="One offer, authored once — it can badge at booking, list on your Deals page, and push to patients, all from here. Tell SmartSpa what you want and watch it become real in the live preview."
        breadcrumbs={[
          { label: "Refill", to: "/app/refill" },
          { label: "Incentives", to: "/app/refill/recognition/inventory" },
          { label: "Offers" },
        ]}
      />

      <RecognitionTabs active="offers" />

      <div className="flex-1 px-4 py-6 lg:px-10 max-w-[960px] w-full mx-auto space-y-5">
        {loadError ? (
          <div className="rounded-2xl border border-rose/30 bg-rose-soft p-5 text-sm">
            <div className="font-semibold text-rose">Couldn't load</div>
            <p className="text-xs text-ink-soft mt-1">{loadError}</p>
          </div>
        ) : (
          <>
            <OfferComposer
              accessToken={accessToken}
              viewAsUserId={viewAsUserId}
              onCreated={() => setRefreshKey((k) => k + 1)}
            />

            <SpaOffersCard accessToken={accessToken} viewAsUserId={viewAsUserId} hideCreate refreshKey={refreshKey} />

            <SmartAbCard accessToken={accessToken} viewAsUserId={viewAsUserId} hideCreate refreshKey={refreshKey} />
          </>
        )}
      </div>
    </div>
  );
}
